using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();
        string novayaStroka = "";

        foreach (char bukva in stroka)
        {
            if (!char.IsDigit(bukva))
            {
                novayaStroka = novayaStroka + bukva;
            }
        }

        Console.WriteLine(novayaStroka);
    }
}