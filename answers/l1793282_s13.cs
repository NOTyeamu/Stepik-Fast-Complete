using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();

        for (int i = 0; i < stroka.Length; i++)
        {
            for (int j = 0; j <= i; j++)
            {
                Console.Write(stroka[j] + " ");
            }
            Console.WriteLine();
        }
    }
}