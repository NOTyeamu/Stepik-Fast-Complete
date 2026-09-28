using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();
        bool nashli = false;

        foreach (char bukva in stroka)
        {
            if (char.IsDigit(bukva))
            {
                Console.WriteLine(bukva);
                nashli = true;
                break;
            }
        }

        if (!nashli)
        {
            Console.WriteLine("Цифр не найдено");
        }
    }
}