using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();
        int maks = -1;

        foreach (char bukva in stroka)
        {
            int cifra = bukva - '0';
            if (cifra > maks)
            {
                maks = cifra;
            }
        }

        Console.WriteLine(maks);
    }
}